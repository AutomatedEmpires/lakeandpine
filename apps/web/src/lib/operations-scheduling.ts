export const SERVICE_VERTICALS = ["estate", "construction", "marine", "commercial"] as const;

export type ServiceVertical = (typeof SERVICE_VERTICALS)[number];

export type TimeSpan = {
  start: string;
  end: string;
};

export type SchedulingJob = {
  id: string;
  vertical: ServiceVertical;
  territoryId: string;
  start: string;
  end: string;
  requiredCrewSize: number;
  requiredSkills: string[];
  qualificationApproved: boolean;
  safeAccessReady: boolean;
  utilitiesReady: boolean;
  constructionReady?: boolean;
  dockAccessReady?: boolean;
  finishRestrictionsAcknowledged: boolean;
  recurringCleanerIds?: string[];
  preferredCleanerIds?: string[];
  urgency?: "standard" | "deadline";
};

export type CleanerCapacity = {
  id: string;
  active: boolean;
  skills: string[];
  verticalExperience: ServiceVertical[];
  availability: TimeSpan[];
  timeOff: TimeSpan[];
  assignments: TimeSpan[];
  assignedJobsToday: number;
  assignedMinutesToday: number;
  assignedMinutesThisWeek: number;
  maxDailyJobs: number;
  maxDailyMinutes: number;
  maxWeeklyMinutes: number;
};

export type AssignmentCandidate = {
  id: string;
  territoryIds: string[];
  cleaners: CleanerCapacity[];
  estimatedTravelMinutes: number;
  travelBufferMinutes: number;
};

export type AssignmentSuggestion = {
  candidateId: string;
  eligible: boolean;
  score: number;
  reasons: string[];
  blockers: string[];
};

export type CrewSearchInput = {
  job: SchedulingJob;
  acceptedCleaners: CleanerCapacity[];
  availableCleaners: CleanerCapacity[];
  travelBufferMinutes: number;
  limit?: number;
};

export type DurationInput = {
  vertical: ServiceVertical;
  squareFeet?: number;
  serviceUnits?: number;
  complexity: "standard" | "detailed" | "restoration";
  crewSize: number;
};

export type DurationEstimate = {
  laborMinutes: number;
  elapsedMinutes: number;
  requiresWalkthrough: boolean;
};

const VERTICAL_BASE_MINUTES: Record<ServiceVertical, number> = {
  estate: 300,
  construction: 420,
  marine: 300,
  commercial: 360,
};

function toMillis(value: string): number {
  return Date.parse(value);
}

function durationMinutes(span: TimeSpan): number {
  return Math.max(0, Math.ceil((toMillis(span.end) - toMillis(span.start)) / 60_000));
}

function overlaps(a: TimeSpan, b: TimeSpan, bufferMinutes = 0): boolean {
  const buffer = bufferMinutes * 60_000;
  return toMillis(a.start) < toMillis(b.end) + buffer && toMillis(a.end) > toMillis(b.start) - buffer;
}

function contains(container: TimeSpan, requested: TimeSpan): boolean {
  return toMillis(container.start) <= toMillis(requested.start) && toMillis(container.end) >= toMillis(requested.end);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function cleanerMeetsIndividualSchedulingConstraints(
  job: SchedulingJob,
  cleaner: CleanerCapacity,
  travelBufferMinutes: number,
): boolean {
  const requestedSpan = { start: job.start, end: job.end };
  const requiredMinutes = durationMinutes(requestedSpan);
  if (
    !cleaner.active ||
    !Number.isFinite(toMillis(job.start)) ||
    !Number.isFinite(toMillis(job.end)) ||
    toMillis(job.end) <= toMillis(job.start)
  ) {
    return false;
  }

  return (
    cleaner.availability.some((span) => contains(span, requestedSpan)) &&
    !cleaner.timeOff.some((span) => overlaps(span, requestedSpan)) &&
    !cleaner.assignments.some((span) =>
      overlaps(span, requestedSpan, travelBufferMinutes),
    ) &&
    cleaner.assignedJobsToday + 1 <= cleaner.maxDailyJobs &&
    cleaner.assignedMinutesToday + requiredMinutes <= cleaner.maxDailyMinutes &&
    cleaner.assignedMinutesThisWeek + requiredMinutes <= cleaner.maxWeeklyMinutes
  );
}

const MAX_CREW_SEARCH_STATES_PER_SIZE = 512;
const MAX_CREW_SEARCH_CANDIDATES = 240;
const MAX_CREW_SEARCH_TRANSITIONS = 1_000_000;

type CrewSearchVariant = {
  cleaners: CleanerCapacity[];
  coverage: string[];
  preference: number;
};

function cleanerSearchPreference(
  cleaner: CleanerCapacity,
  job: SchedulingJob,
): number {
  const requiredSkillCount = job.requiredSkills.filter((skill) =>
    cleaner.skills.includes(skill),
  ).length;
  const utilization =
    cleaner.maxWeeklyMinutes > 0
      ? cleaner.assignedMinutesThisWeek / cleaner.maxWeeklyMinutes
      : 1;
  const continuityPreference =
    (job.recurringCleanerIds?.includes(cleaner.id) ? 1_000 : 0) +
    (job.preferredCleanerIds?.includes(cleaner.id) ? 500 : 0);
  return (
    continuityPreference +
    requiredSkillCount * 100 +
    (cleaner.verticalExperience.includes(job.vertical) ? 40 : 0) +
    Math.max(0, Math.round((1 - utilization) * 20))
  );
}

function coverageKey(coverage: readonly string[]): string {
  return [...coverage].sort().join("\u001f");
}

function trimCrewSearchStates(
  states: Map<string, CrewSearchVariant>,
  requiredSkillCount: number,
): void {
  if (states.size <= MAX_CREW_SEARCH_STATES_PER_SIZE) return;
  const retained = [...states.entries()]
    .sort((a, b) => {
      const aCoverage = a[1].coverage.length;
      const bCoverage = b[1].coverage.length;
      return (
        Number(bCoverage === requiredSkillCount) -
          Number(aCoverage === requiredSkillCount) ||
        bCoverage - aCoverage ||
        b[1].preference - a[1].preference ||
        a[0].localeCompare(b[0])
      );
    })
    .slice(0, MAX_CREW_SEARCH_STATES_PER_SIZE);
  states.clear();
  for (const [key, variant] of retained) states.set(key, variant);
}

function selectSkillAwareCandidates(
  cleaners: CleanerCapacity[],
  job: SchedulingJob,
  requiredSkillSet: ReadonlySet<string>,
  remainingSlots: number,
): CleanerCapacity[] {
  const frequencies = new Map<string, number>();
  for (const cleaner of cleaners) {
    for (const skill of new Set(cleaner.skills)) {
      if (requiredSkillSet.has(skill)) {
        frequencies.set(skill, (frequencies.get(skill) ?? 0) + 1);
      }
    }
  }

  const groups = new Map<
    string,
    { coverage: string[]; cleaners: CleanerCapacity[] }
  >();
  for (const cleaner of cleaners) {
    const coverage = unique(
      cleaner.skills.filter((skill) => requiredSkillSet.has(skill)),
    ).sort();
    const key = coverageKey(coverage);
    const group = groups.get(key) ?? { coverage, cleaners: [] };
    group.cleaners.push(cleaner);
    groups.set(key, group);
  }

  const orderedGroups = [...groups.values()];
  for (const group of orderedGroups) {
    group.cleaners.sort(
      (a, b) =>
        cleanerSearchPreference(b, job) - cleanerSearchPreference(a, job) ||
        a.id.localeCompare(b.id),
    );
  }
  orderedGroups.sort((a, b) => {
    const rarity = (coverage: string[]) =>
      coverage.reduce(
        (score, skill) => score + 1 / Math.max(1, frequencies.get(skill) ?? 1),
        0,
      );
    return (
      rarity(b.coverage) - rarity(a.coverage) ||
      b.coverage.length - a.coverage.length ||
      cleanerSearchPreference(b.cleaners[0], job) -
        cleanerSearchPreference(a.cleaners[0], job) ||
      coverageKey(a.coverage).localeCompare(coverageKey(b.coverage))
    );
  });

  const candidateLimit = Math.max(
    MAX_CREW_SEARCH_CANDIDATES,
    remainingSlots,
  );
  const selected: CleanerCapacity[] = [];
  for (
    let round = 0;
    round < remainingSlots && selected.length < candidateLimit;
    round += 1
  ) {
    for (const group of orderedGroups) {
      const cleaner = group.cleaners[round];
      if (cleaner) selected.push(cleaner);
      if (selected.length >= candidateLimit) break;
    }
  }
  return selected;
}

/**
 * Builds a bounded, skill-aware crew search. Candidates are filtered for their
 * individual hard constraints before search. Accepted cleaners are revalidated
 * against those same constraints and then remain fixed in every crew. Dynamic
 * programming retains complementary skill states, so a valid crew is not lost
 * merely because it appears late lexicographically.
 */
export function buildBoundedCrewGroups({
  job,
  acceptedCleaners,
  availableCleaners,
  travelBufferMinutes,
  limit = 2_000,
}: CrewSearchInput): CleanerCapacity[][] {
  if (
    acceptedCleaners.some(
      (cleaner) =>
        !cleanerMeetsIndividualSchedulingConstraints(
          job,
          cleaner,
          travelBufferMinutes,
        ),
    )
  ) {
    return [];
  }

  const remainingSlots = job.requiredCrewSize - acceptedCleaners.length;
  if (remainingSlots < 0 || limit < 1) return [];
  if (remainingSlots === 0) return [acceptedCleaners];

  const acceptedIds = new Set(acceptedCleaners.map((cleaner) => cleaner.id));
  const requiredSkills = unique(job.requiredSkills);
  const requiredSkillSet = new Set(requiredSkills);
  const acceptedCoverage = unique(
    acceptedCleaners.flatMap((cleaner) =>
      cleaner.skills.filter((skill) => requiredSkillSet.has(skill)),
    ),
  );
  const individuallyEligibleCleaners = availableCleaners.filter(
    (cleaner) =>
      !acceptedIds.has(cleaner.id) &&
      cleanerMeetsIndividualSchedulingConstraints(
        job,
        cleaner,
        travelBufferMinutes,
      ),
  );
  if (individuallyEligibleCleaners.length < remainingSlots) return [];
  const eligibleCleaners = selectSkillAwareCandidates(
    individuallyEligibleCleaners,
    job,
    requiredSkillSet,
    remainingSlots,
  );
  if (eligibleCleaners.length < remainingSlots) return [];

  const states = Array.from(
    { length: remainingSlots + 1 },
    () => new Map<string, CrewSearchVariant>(),
  );
  states[0].set(coverageKey(acceptedCoverage), {
    cleaners: [],
    coverage: acceptedCoverage,
    preference: 0,
  });

  let transitions = 0;
  candidateLoop: for (const [cleanerIndex, cleaner] of eligibleCleaners.entries()) {
    const cleanerSkills = cleaner.skills.filter((skill) =>
      requiredSkillSet.has(skill),
    );
    const maxSelected = Math.min(remainingSlots - 1, cleanerIndex);
    for (let selected = maxSelected; selected >= 0; selected -= 1) {
      const sourceStates = [...states[selected].values()];
      for (const source of sourceStates) {
        transitions += 1;
        if (transitions > MAX_CREW_SEARCH_TRANSITIONS) break candidateLoop;
        const coverage = unique([...source.coverage, ...cleanerSkills]);
        const key = coverageKey(coverage);
        const variant = {
          cleaners: [...source.cleaners, cleaner],
          coverage,
          preference:
            source.preference + cleanerSearchPreference(cleaner, job),
        };
        const current = states[selected + 1].get(key);
        if (
          !current ||
          variant.preference > current.preference ||
          (variant.preference === current.preference &&
            variant.cleaners
              .map((member) => member.id)
              .join("+")
              .localeCompare(
                current.cleaners.map((member) => member.id).join("+"),
              ) < 0)
        ) {
          states[selected + 1].set(key, variant);
        }
      }
      trimCrewSearchStates(states[selected + 1], requiredSkills.length);
    }
  }

  return [...states[remainingSlots].values()]
    .sort(
      (a, b) =>
        Number(b.coverage.length === requiredSkills.length) -
          Number(a.coverage.length === requiredSkills.length) ||
        b.coverage.length - a.coverage.length ||
        b.preference - a.preference ||
        a.cleaners
          .map((member) => member.id)
          .join("+")
          .localeCompare(b.cleaners.map((member) => member.id).join("+")),
    )
    .slice(0, limit)
    .map((variant) => [...acceptedCleaners, ...variant.cleaners]);
}

export function requiredElapsedMinutes(
  laborMinutes: number,
  crewSize: number,
): number {
  if (
    !Number.isFinite(laborMinutes) ||
    !Number.isFinite(crewSize) ||
    laborMinutes <= 0 ||
    crewSize < 1
  ) {
    throw new Error("Labor minutes and crew size must be positive numbers");
  }
  return Math.ceil(laborMinutes / Math.floor(crewSize) / 30) * 30;
}

export function estimateJobDuration(input: DurationInput): DurationEstimate {
  const squareFeet = Math.max(0, input.squareFeet ?? 0);
  const serviceUnits = Math.max(1, input.serviceUnits ?? 1);
  const areaMinutes = squareFeet > 1_500 ? Math.ceil((squareFeet - 1_500) / 500) * 45 : 0;
  const unitMinutes = Math.max(0, serviceUnits - 1) * 45;
  const multiplier = input.complexity === "restoration" ? 1.65 : input.complexity === "detailed" ? 1.3 : 1;
  const laborMinutes = Math.min(
    2_400,
    Math.max(120, Math.ceil(((VERTICAL_BASE_MINUTES[input.vertical] + areaMinutes + unitMinutes) * multiplier) / 30) * 30),
  );
  const crewSize = Math.max(1, input.crewSize);
  const elapsedMinutes = requiredElapsedMinutes(laborMinutes, crewSize);
  const requiresWalkthrough =
    input.vertical === "construction" ||
    squareFeet >= 5_000 ||
    input.complexity === "restoration" ||
    laborMinutes >= 960;

  return { laborMinutes, elapsedMinutes, requiresWalkthrough };
}

export function evaluateAssignment(job: SchedulingJob, candidate: AssignmentCandidate): AssignmentSuggestion {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const requestedSpan = { start: job.start, end: job.end };
  const requiredMinutes = durationMinutes(requestedSpan);
  const activeCleaners = candidate.cleaners.filter((cleaner) => cleaner.active);

  if (!Number.isFinite(toMillis(job.start)) || !Number.isFinite(toMillis(job.end)) || toMillis(job.end) <= toMillis(job.start)) {
    blockers.push("Job start and end must define a valid positive interval");
  }

  if (!job.qualificationApproved) blockers.push("Service qualification is not approved");
  if (!candidate.territoryIds.includes(job.territoryId)) blockers.push("Outside the candidate territory");
  if (!job.safeAccessReady) blockers.push("Safe access is not confirmed");
  if (!job.utilitiesReady) blockers.push("Required utilities are not confirmed");
  if (!job.finishRestrictionsAcknowledged) blockers.push("Finish and product restrictions are not acknowledged");
  if (job.vertical === "construction" && !job.constructionReady) blockers.push("Construction readiness is not confirmed");
  if (job.vertical === "marine" && !job.dockAccessReady) blockers.push("Dock or vessel access is not confirmed");
  if (activeCleaners.length < job.requiredCrewSize) blockers.push("Crew size is below the job requirement");

  const coveredSkills = new Set(activeCleaners.flatMap((cleaner) => cleaner.skills));
  const missingSkills = job.requiredSkills.filter((skill) => !coveredSkills.has(skill));
  if (missingSkills.length) blockers.push(`Missing skills: ${missingSkills.join(", ")}`);

  for (const cleaner of activeCleaners) {
    if (!cleaner.availability.some((span) => contains(span, requestedSpan))) {
      blockers.push(`Cleaner ${cleaner.id} is outside an available shift`);
    }
    if (cleaner.timeOff.some((span) => overlaps(span, requestedSpan))) {
      blockers.push(`Cleaner ${cleaner.id} has approved time off`);
    }
    if (cleaner.assignments.some((span) => overlaps(span, requestedSpan, candidate.travelBufferMinutes))) {
      blockers.push(`Cleaner ${cleaner.id} has an overlapping job or travel buffer`);
    }
    if (cleaner.assignedJobsToday + 1 > cleaner.maxDailyJobs) {
      blockers.push(`Cleaner ${cleaner.id} would exceed daily job capacity`);
    }
    if (cleaner.assignedMinutesToday + requiredMinutes > cleaner.maxDailyMinutes) {
      blockers.push(`Cleaner ${cleaner.id} would exceed daily capacity`);
    }
    if (cleaner.assignedMinutesThisWeek + requiredMinutes > cleaner.maxWeeklyMinutes) {
      blockers.push(`Cleaner ${cleaner.id} would exceed weekly capacity`);
    }
  }

  if (blockers.length) {
    return { candidateId: candidate.id, eligible: false, score: 0, reasons, blockers: unique(blockers) };
  }

  let score = 30;
  reasons.push("All hard scheduling requirements are satisfied");
  const cleanerIds = activeCleaners.map((cleaner) => cleaner.id);
  const knownCrewCount = cleanerIds.filter((id) => job.recurringCleanerIds?.includes(id)).length;
  if (knownCrewCount) {
    score += Math.min(18, knownCrewCount * 9);
    reasons.push("Preserves recurring crew continuity");
  }
  const preferredCount = cleanerIds.filter((id) => job.preferredCleanerIds?.includes(id)).length;
  if (preferredCount) {
    score += Math.min(10, preferredCount * 5);
    reasons.push("Includes a customer-preferred cleaner");
  }
  const experiencedCount = activeCleaners.filter((cleaner) => cleaner.verticalExperience.includes(job.vertical)).length;
  if (experiencedCount >= job.requiredCrewSize) {
    score += 16;
    reasons.push("Crew has relevant property and finish experience");
  }
  const travelScore = Math.max(0, 18 - Math.ceil(candidate.estimatedTravelMinutes / 5) * 2);
  score += travelScore;
  if (travelScore >= 12) reasons.push("Low travel burden");

  const weeklyLoads = activeCleaners.map((cleaner) => cleaner.assignedMinutesThisWeek / cleaner.maxWeeklyMinutes);
  const averageLoad = weeklyLoads.reduce((sum, value) => sum + value, 0) / Math.max(1, weeklyLoads.length);
  const balanceScore = Math.max(0, Math.round((1 - averageLoad) * 12));
  score += balanceScore;
  if (balanceScore >= 7) reasons.push("Balances weekly crew workload");
  if (job.urgency === "deadline") {
    score += 4;
    reasons.push("Meets a documented deadline window");
  }

  return {
    candidateId: candidate.id,
    eligible: true,
    score: Math.min(100, score),
    reasons,
    blockers: [],
  };
}

export function rankAssignmentSuggestions(
  job: SchedulingJob,
  candidates: AssignmentCandidate[],
): AssignmentSuggestion[] {
  return candidates
    .map((candidate) => evaluateAssignment(job, candidate))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.candidateId.localeCompare(b.candidateId));
}
