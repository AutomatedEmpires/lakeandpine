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
  assignedMinutesToday: number;
  assignedMinutesThisWeek: number;
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
  const elapsedMinutes = Math.ceil(laborMinutes / crewSize / 30) * 30;
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
