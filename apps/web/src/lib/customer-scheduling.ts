import {
  evaluateAssignment,
  type AssignmentCandidate,
  type SchedulingJob,
  type ServiceVertical,
} from "./operations-scheduling.ts";

export const CUSTOMER_SCHEDULING_PATHS = [
  "direct",
  "conditional_hold",
  "consultation",
  "insufficient_data",
  "unsupported_territory",
  "no_capacity",
] as const;

export type CustomerSchedulingPath = (typeof CUSTOMER_SCHEDULING_PATHS)[number];

export type SchedulingScope = {
  program: ServiceVertical;
  postalCode: string;
  context: string;
  sizeBand: "compact" | "standard" | "large" | "exceptional";
  condition: "maintained" | "detailed" | "project";
  cadence: "project" | "weekly" | "biweekly" | "monthly" | "seasonal" | "custom";
  zoneCount: number;
  siteReady: boolean;
  accessComplex: boolean;
  finishSensitive: boolean;
  finishRestrictionsAcknowledged: boolean;
};

export type SchedulingPolicy = {
  id: string;
  version: number;
  status: "draft" | "active" | "retired";
  territoryId: string;
  territoryTimeZone: string;
  serviceId: ServiceVertical;
  schedulingPath: "direct" | "conditional_hold" | "consultation";
  conditionKey: string | null;
  conditionLabel: string | null;
  allowedContexts: string[];
  allowedSizeBands: SchedulingScope["sizeBand"][];
  allowedConditions: SchedulingScope["condition"][];
  allowedCadences: SchedulingScope["cadence"][];
  laborMinutes: number;
  requiredCrewSize: number;
  requiredSkills: string[];
  travelBufferMinutes: number;
  minimumLeadHours: number;
  horizonDays: number;
  operatingStart: string;
  operatingEnd: string;
  selectionHoldMinutes: number;
  conditionalHoldMinutes: number;
};

export type SchedulingClassification = {
  path: CustomerSchedulingPath;
  publicReason: string;
  internalReasons: string[];
  conditionKey: string | null;
  conditionLabel: string | null;
};

export type CapacityCandidateSlot = {
  id: string;
  start: string;
  end: string;
  arrivalWindow: string;
  candidates: AssignmentCandidate[];
};

export type PublicAvailabilitySlot = {
  id: string;
  date: string;
  start: string;
  end: string;
  arrivalWindow: string;
  timeZone: string;
  state: "available_to_hold";
  schedulingPath: "direct" | "conditional_hold";
  holdMinutes: number;
  conditionLabel: string | null;
};

export type InternalSlotEvidence = {
  slotId: string;
  policyId: string;
  policyVersion: number;
  candidateId: string;
  score: number;
  reasons: string[];
};

export type AvailabilityProjection = {
  classification: SchedulingClassification;
  publicSlots: PublicAvailabilitySlot[];
  internalEvidence: InternalSlotEvidence[];
};

function missingScope(scope: SchedulingScope): string[] {
  const missing: string[] = [];
  if (!scope.postalCode.trim()) missing.push("postal_code");
  if (!scope.context.trim()) missing.push("property_context");
  if (!Number.isInteger(scope.zoneCount) || scope.zoneCount < 1) missing.push("zone_count");
  return missing;
}

function localDateForInstant(instant: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localTimeForInstant(instant: string, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function policyTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function overlaps(
  start: number,
  end: number,
  window: { start: string; end: string },
): boolean {
  return Date.parse(window.start) < end && Date.parse(window.end) > start;
}

export function classifySchedulingRequest(input: {
  scope: SchedulingScope;
  territoryEligible: boolean;
  policy: SchedulingPolicy | null;
  capacityAvailable?: boolean;
}): SchedulingClassification {
  const { scope, policy } = input;
  const missing = missingScope(scope);
  if (missing.length > 0) {
    return {
      path: "insufficient_data",
      publicReason: "Add the remaining property details to see scheduling options.",
      internalReasons: missing.map((field) => `missing:${field}`),
      conditionKey: null,
      conditionLabel: null,
    };
  }
  if (!input.territoryEligible) {
    return {
      path: "unsupported_territory",
      publicReason: "This location is not in a verified direct-scheduling territory.",
      internalReasons: ["territory:not_active_for_postal_code"],
      conditionKey: null,
      conditionLabel: null,
    };
  }
  if (!policy || policy.status !== "active" || policy.serviceId !== scope.program) {
    return {
      path: "consultation",
      publicReason: "This service needs an operator to confirm scope before scheduling.",
      internalReasons: ["policy:no_active_service_territory_policy"],
      conditionKey: null,
      conditionLabel: null,
    };
  }

  const blockers: string[] = [];
  if (policy.allowedContexts.length > 0 && !policy.allowedContexts.includes(scope.context)) {
    blockers.push("scope:context_not_direct_enabled");
  }
  if (!policy.allowedSizeBands.includes(scope.sizeBand)) blockers.push("scope:size_outside_policy");
  if (!policy.allowedConditions.includes(scope.condition)) blockers.push("scope:condition_outside_policy");
  if (!policy.allowedCadences.includes(scope.cadence)) blockers.push("scope:cadence_outside_policy");
  if (!scope.siteReady) blockers.push("readiness:site_not_ready");
  if (scope.accessComplex) blockers.push("access:operator_coordination_required");

  if (policy.schedulingPath === "consultation" || blockers.length > 0) {
    return {
      path: "consultation",
      publicReason:
        blockers.includes("access:operator_coordination_required")
          ? "Access or safety coordination needs an operator before a time can be reserved."
          : "This scope needs an operator or walkthrough before scheduling.",
      internalReasons:
        policy.schedulingPath === "consultation"
          ? ["policy:consultation", ...blockers]
          : blockers,
      conditionKey: null,
      conditionLabel: null,
    };
  }
  if (input.capacityAvailable === false) {
    return {
      path: "no_capacity",
      publicReason: "No capacity-backed times are currently available in the selected horizon.",
      internalReasons: ["capacity:no_qualifying_slot"],
      conditionKey: null,
      conditionLabel: null,
    };
  }
  if (policy.schedulingPath === "conditional_hold") {
    return {
      path: "conditional_hold",
      publicReason: "Choose a real service window to hold while the remaining condition is reviewed.",
      internalReasons: [`policy:${policy.id}@${policy.version}`, "policy:conditional_hold"],
      conditionKey: policy.conditionKey,
      conditionLabel: policy.conditionLabel,
    };
  }
  return {
    path: "direct",
    publicReason: "Choose a capacity-backed service window.",
    internalReasons: [`policy:${policy.id}@${policy.version}`, "policy:direct"],
    conditionKey: null,
    conditionLabel: null,
  };
}

export function projectCapacityBackedAvailability(input: {
  scope: SchedulingScope;
  territoryEligible: boolean;
  policy: SchedulingPolicy | null;
  slots: CapacityCandidateSlot[];
  now?: string;
  blackoutWindows?: { start: string; end: string }[];
}): AvailabilityProjection {
  const initial = classifySchedulingRequest({
    scope: input.scope,
    territoryEligible: input.territoryEligible,
    policy: input.policy,
  });
  if (!input.policy || !["direct", "conditional_hold"].includes(initial.path)) {
    return { classification: initial, publicSlots: [], internalEvidence: [] };
  }

  const policy = input.policy;
  const publicSlots: PublicAvailabilitySlot[] = [];
  const internalEvidence: InternalSlotEvidence[] = [];
  const now = Date.parse(input.now ?? new Date().toISOString());
  const minimumStart = now + policy.minimumLeadHours * 60 * 60 * 1_000;
  const maximumStart = now + policy.horizonDays * 24 * 60 * 60 * 1_000;
  const requiredElapsedMinutes = Math.ceil(
    policy.laborMinutes / policy.requiredCrewSize / 30,
  ) * 30;
  const operatingStart = policyTimeToMinutes(policy.operatingStart);
  const operatingEnd = policyTimeToMinutes(policy.operatingEnd);
  for (const slot of input.slots) {
    const start = Date.parse(slot.start);
    const end = Date.parse(slot.end);
    const localStart = localTimeForInstant(slot.start, policy.territoryTimeZone);
    const localEnd = localTimeForInstant(slot.end, policy.territoryTimeZone);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < minimumStart ||
      start > maximumStart ||
      end - start !== requiredElapsedMinutes * 60_000 ||
      localDateForInstant(slot.start, policy.territoryTimeZone) !==
        localDateForInstant(slot.end, policy.territoryTimeZone) ||
      !Number.isFinite(operatingStart) ||
      !Number.isFinite(operatingEnd) ||
      localStart < operatingStart ||
      localEnd > operatingEnd ||
      (input.blackoutWindows ?? []).some((window) => overlaps(start, end, window))
    ) continue;
    const job: SchedulingJob = {
      id: `availability:${slot.id}`,
      vertical: input.scope.program,
      territoryId: policy.territoryId,
      start: slot.start,
      end: slot.end,
      requiredCrewSize: policy.requiredCrewSize,
      requiredSkills: policy.requiredSkills,
      qualificationApproved: ["direct", "conditional_hold"].includes(initial.path),
      safeAccessReady: !input.scope.accessComplex,
      utilitiesReady: input.scope.siteReady,
      constructionReady: input.scope.program === "construction" ? input.scope.siteReady : undefined,
      dockAccessReady: input.scope.program === "marine" ? !input.scope.accessComplex : undefined,
      finishRestrictionsAcknowledged: input.scope.finishRestrictionsAcknowledged,
    };
    const eligible = slot.candidates
      .map((candidate) => {
        const policyCandidate = {
          ...candidate,
          travelBufferMinutes: policy.travelBufferMinutes,
        };
        return { candidate: policyCandidate, result: evaluateAssignment(job, policyCandidate) };
      })
      .filter((item) => item.result.eligible)
      .sort(
        (left, right) =>
          right.result.score - left.result.score ||
          left.candidate.id.localeCompare(right.candidate.id),
      )[0];
    if (!eligible) continue;

    const schedulingPath = initial.path as "direct" | "conditional_hold";
    publicSlots.push({
      id: slot.id,
      date: localDateForInstant(slot.start, policy.territoryTimeZone),
      start: slot.start,
      end: slot.end,
      arrivalWindow: slot.arrivalWindow,
      timeZone: policy.territoryTimeZone,
      state: "available_to_hold",
      schedulingPath,
      holdMinutes:
        schedulingPath === "conditional_hold"
          ? policy.conditionalHoldMinutes
          : policy.selectionHoldMinutes,
      conditionLabel: schedulingPath === "conditional_hold" ? policy.conditionLabel : null,
    });
    internalEvidence.push({
      slotId: slot.id,
      policyId: policy.id,
      policyVersion: policy.version,
      candidateId: eligible.candidate.id,
      score: eligible.result.score,
      reasons: eligible.result.reasons,
    });
  }

  const classification = classifySchedulingRequest({
    scope: input.scope,
    territoryEligible: input.territoryEligible,
    policy,
    capacityAvailable: publicSlots.length > 0,
  });
  return { classification, publicSlots, internalEvidence };
}
