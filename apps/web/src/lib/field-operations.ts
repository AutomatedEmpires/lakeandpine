export const STANDARD_ARRIVAL_WINDOWS = [
  { id: "08:00-10:00", label: "8:00–10:00 AM", startMinutes: 8 * 60, endMinutes: 10 * 60 },
  { id: "10:00-12:00", label: "10:00 AM–12:00 PM", startMinutes: 10 * 60, endMinutes: 12 * 60 },
  { id: "12:00-14:00", label: "12:00–2:00 PM", startMinutes: 12 * 60, endMinutes: 14 * 60 },
  { id: "14:00-16:00", label: "2:00–4:00 PM", startMinutes: 14 * 60, endMinutes: 16 * 60 },
] as const;

export type ArrivalWindowId = (typeof STANDARD_ARRIVAL_WINDOWS)[number]["id"];

export type BranchSchedulingRules = {
  operatingStartMinutes: number;
  latestArrivalMinutes: number;
  hardFinishMinutes: number;
};

export const DEFAULT_BRANCH_SCHEDULING_RULES: BranchSchedulingRules = {
  operatingStartMinutes: 8 * 60,
  latestArrivalMinutes: 16 * 60,
  hardFinishMinutes: 19 * 60,
};

export type WindowFeasibility = {
  id: ArrivalWindowId;
  label: string;
  eligible: boolean;
  earliestStartMinutes: number | null;
  latestStartMinutes: number | null;
  reason: string | null;
};

export function arrivalWindowForStartMinutes(startMinutes: number) {
  if (!validMinutes(startMinutes)) throw new Error("Arrival minutes are invalid");
  return STANDARD_ARRIVAL_WINDOWS.find((window, index) =>
    startMinutes >= window.startMinutes &&
      (startMinutes < window.endMinutes ||
        (index === STANDARD_ARRIVAL_WINDOWS.length - 1 && startMinutes === window.endMinutes)),
  ) ?? null;
}

export function rescheduleProposalExpiry(
  currentStartAt: string,
  proposedStartAt: string,
) {
  const currentStart = Date.parse(currentStartAt);
  const proposedStart = Date.parse(proposedStartAt);
  if (!Number.isFinite(currentStart) || !Number.isFinite(proposedStart)) {
    throw new Error("Reschedule proposal expiry requires valid schedule instants");
  }
  return new Date(Math.min(currentStart, proposedStart)).toISOString();
}

function validMinutes(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 24 * 60;
}

export function feasibleArrivalWindows(
  elapsedMinutes: number,
  rules: BranchSchedulingRules = DEFAULT_BRANCH_SCHEDULING_RULES,
): WindowFeasibility[] {
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) {
    throw new Error("Elapsed job minutes must be positive");
  }
  if (
    !validMinutes(rules.operatingStartMinutes) ||
    !validMinutes(rules.latestArrivalMinutes) ||
    !validMinutes(rules.hardFinishMinutes) ||
    rules.operatingStartMinutes >= rules.latestArrivalMinutes ||
    rules.latestArrivalMinutes >= rules.hardFinishMinutes
  ) {
    throw new Error("Branch scheduling rules are invalid");
  }

  const hardLatestStart = Math.min(
    rules.latestArrivalMinutes,
    rules.hardFinishMinutes - Math.ceil(elapsedMinutes),
  );

  return STANDARD_ARRIVAL_WINDOWS.map((window) => {
    const earliestStartMinutes = Math.max(
      window.startMinutes,
      rules.operatingStartMinutes,
    );
    const latestStartMinutes = Math.min(
      window.endMinutes,
      hardLatestStart,
    );
    const eligible = latestStartMinutes >= earliestStartMinutes;
    return {
      id: window.id,
      label: window.label,
      eligible,
      earliestStartMinutes: eligible ? earliestStartMinutes : null,
      latestStartMinutes: eligible ? latestStartMinutes : null,
      reason: eligible
        ? null
        : `A ${elapsedMinutes}-minute visit cannot arrive in this window and finish by ${formatClockMinutes(rules.hardFinishMinutes)}.`,
    };
  });
}

export function evaluateLocalSchedule(
  startMinutes: number,
  endMinutes: number,
  rules: BranchSchedulingRules = DEFAULT_BRANCH_SCHEDULING_RULES,
) {
  const blockers: string[] = [];
  if (!validMinutes(startMinutes) || !validMinutes(endMinutes) || endMinutes <= startMinutes) {
    blockers.push("The planned work interval must be valid and end after it starts.");
    return { eligible: false, blockers };
  }
  if (startMinutes < rules.operatingStartMinutes) {
    blockers.push(`Arrival is before ${formatClockMinutes(rules.operatingStartMinutes)}.`);
  }
  if (startMinutes > rules.latestArrivalMinutes) {
    blockers.push(`Arrival is after the ${formatClockMinutes(rules.latestArrivalMinutes)} cutoff.`);
  }
  if (endMinutes > rules.hardFinishMinutes) {
    blockers.push(`Work would continue beyond the ${formatClockMinutes(rules.hardFinishMinutes)} hard finish.`);
  }
  return { eligible: blockers.length === 0, blockers };
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

export function haversineMiles(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
) {
  for (const point of [origin, destination]) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error("Latitude or longitude is invalid");
    }
  }
  const earthRadiusMiles = 3_958.7613;
  const latitudeDelta = degreesToRadians(destination.latitude - origin.latitude);
  const longitudeDelta = degreesToRadians(destination.longitude - origin.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(degreesToRadians(origin.latitude)) *
      Math.cos(degreesToRadians(destination.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function assessServiceRadius(
  distanceMiles: number | null,
  standardRadiusMiles = 30,
) {
  if (!Number.isFinite(standardRadiusMiles) || standardRadiusMiles <= 0) {
    throw new Error("Standard service radius must be positive");
  }
  if (distanceMiles === null) {
    return {
      status: "manual_review" as const,
      flagged: true,
      explanation: "Distance has not been verified; route review is required before confirmation.",
    };
  }
  if (!Number.isFinite(distanceMiles) || distanceMiles < 0) {
    throw new Error("Distance must be zero or greater");
  }
  if (distanceMiles > standardRadiusMiles) {
    return {
      status: "outside_standard_radius" as const,
      flagged: true,
      explanation: `${distanceMiles.toFixed(1)} miles is outside the ${standardRadiusMiles.toFixed(0)}-mile standard branch radius. The request remains open for manager review.`,
    };
  }
  return {
    status: "inside_standard_radius" as const,
    flagged: false,
    explanation: `${distanceMiles.toFixed(1)} miles is inside the ${standardRadiusMiles.toFixed(0)}-mile standard branch radius.`,
  };
}

export function lateArrivalMessage(minutesLate: 15 | 30, firstName: string | null) {
  const greeting = firstName?.trim() ? `Hi ${firstName.trim()}, ` : "Hi, ";
  return `${greeting}your Lake & Pine team is running about ${minutesLate} minutes behind. We’ll keep you updated here. Your service scope remains unchanged.`;
}

export function canSendLateArrivalUpdate(
  scheduleStatus: string,
  startAt: string,
  endAt: string,
  now = Date.now(),
) {
  if (scheduleStatus === "en_route" || scheduleStatus === "in_progress") {
    return true;
  }
  if (scheduleStatus !== "confirmed") return false;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return false;
  }
  // A confirmed cleaner may report emerging travel delay shortly before the
  // planned arrival, but a future visit must never receive a false late notice.
  return now >= start - 60 * 60 * 1000 && now <= end;
}

export function formatClockMinutes(minutes: number) {
  if (!validMinutes(minutes)) throw new Error("Clock minutes are invalid");
  const normalized = minutes === 24 * 60 ? 0 : minutes;
  const hours = Math.floor(normalized / 60);
  const minutePart = normalized % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutePart).padStart(2, "0")} ${suffix}`;
}
