export const PLANNING_DATE_TIME_ZONE = "America/Los_Angeles";

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLANNING_HORIZON_MONTHS = 18;

export type PlanningDateBounds = {
  min: string;
  max: string;
};

function formatCalendarDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PLANNING_DATE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function formatComponents(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseCalendarDate(value: string) {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(0);
  instant.setUTCHours(12, 0, 0, 0);
  instant.setUTCFullYear(year, month - 1, day);
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() + 1 !== month ||
    instant.getUTCDate() !== day ||
    formatCalendarDate(instant) !== value
  ) {
    return null;
  }
  return { year, month, day };
}

function addCalendarMonths(
  value: { year: number; month: number; day: number },
  months: number,
) {
  const targetMonthIndex = value.year * 12 + value.month - 1 + months;
  const year = Math.floor(targetMonthIndex / 12);
  const monthIndex = targetMonthIndex - year * 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return formatComponents(year, monthIndex + 1, Math.min(value.day, lastDay));
}

export function getPlanningDateBounds(now = new Date()): PlanningDateBounds {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Planning date bounds require a valid current instant");
  }
  const min = formatCalendarDate(now);
  const parsed = parseCalendarDate(min);
  if (!parsed) {
    throw new Error("The operating calendar date could not be resolved");
  }
  return {
    min,
    max: addCalendarMonths(parsed, PLANNING_HORIZON_MONTHS),
  };
}

export function isPlanningDateAllowed(
  value: string,
  bounds: PlanningDateBounds = getPlanningDateBounds(),
) {
  return (
    parseCalendarDate(value) !== null &&
    value >= bounds.min &&
    value <= bounds.max
  );
}
