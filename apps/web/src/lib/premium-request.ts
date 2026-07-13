export const PREMIUM_PROGRAMS = ["estate", "construction", "marine", "commercial"] as const;
export type PremiumProgram = (typeof PREMIUM_PROGRAMS)[number];

export type RequestPlanningInput = {
  program: PremiumProgram;
  sizeBand: "compact" | "standard" | "large" | "exceptional";
  condition: "maintained" | "detailed" | "project";
  zoneCount: number;
  deadlineCritical: boolean;
  finishSensitive: boolean;
  accessComplex: boolean;
};

export type RequestPlanningDirection = {
  estimatedCrewSize: number;
  estimatedMinutes: number;
  reviewPath: "remote scope review" | "operator call" | "walkthrough recommended";
  factors: string[];
};

const BASE_MINUTES: Record<PremiumProgram, number> = {
  estate: 300,
  construction: 480,
  marine: 240,
  commercial: 360,
};

const SIZE_MULTIPLIER: Record<RequestPlanningInput["sizeBand"], number> = {
  compact: 0.7,
  standard: 1,
  large: 1.45,
  exceptional: 2,
};

export function deriveRequestPlanning(
  input: RequestPlanningInput,
): RequestPlanningDirection {
  const factors: string[] = [];
  let minutes = BASE_MINUTES[input.program] * SIZE_MULTIPLIER[input.sizeBand];

  if (input.condition === "detailed") {
    minutes *= 1.25;
    factors.push("detail-intensive condition");
  }
  if (input.condition === "project") {
    minutes *= 1.45;
    factors.push("project or handoff condition");
  }
  if (input.zoneCount > 8) {
    minutes += (input.zoneCount - 8) * 20;
    factors.push("extended room or zone count");
  }
  if (input.finishSensitive) {
    minutes *= 1.1;
    factors.push("finish-sensitive scope");
  }
  if (input.accessComplex) {
    minutes += 45;
    factors.push("access or mobilization coordination");
  }
  if (input.deadlineCritical) factors.push("handoff or arrival deadline");

  const estimatedMinutes = Math.ceil(minutes / 30) * 30;
  const estimatedCrewSize = Math.max(1, Math.min(4, Math.ceil(estimatedMinutes / 300)));
  const walkthroughRecommended =
    input.program === "construction" ||
    input.program === "commercial" ||
    input.sizeBand === "exceptional" ||
    estimatedMinutes >= 720;
  const operatorCall =
    input.program === "marine" || input.deadlineCritical || input.finishSensitive || input.accessComplex;

  return {
    estimatedCrewSize,
    estimatedMinutes,
    reviewPath: walkthroughRecommended
      ? "walkthrough recommended"
      : operatorCall
        ? "operator call"
        : "remote scope review",
    factors: factors.length ? factors : ["standard reviewed scope"],
  };
}
