// Rule-based request horizon only: customers may express a preference for
// tomorrow through +35 days, Monday–Saturday, in one of four arrival windows.
// These values do not represent live capacity or confirm an appointment.

export const ARRIVAL_WINDOWS = ["8:00 AM", "10:00 AM", "12:00 PM", "2:00 PM"] as const;

export const MIN_LEAD_DAYS = 1;
export const MAX_HORIZON_DAYS = 35;

export function isBookableDate(isoDate: string, today = new Date()): boolean {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  if (date.getUTCDay() === 0 && date.getDay() === 0) return false; // Sundays off
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((date.getTime() - startOfToday.getTime()) / 86_400_000);
  return diffDays >= MIN_LEAD_DAYS && diffDays <= MAX_HORIZON_DAYS && date.getDay() !== 0;
}

export function isBookableWindow(window: string): boolean {
  return (ARRIVAL_WINDOWS as readonly string[]).includes(window);
}

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatLongDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
