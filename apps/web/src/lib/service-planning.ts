export const JOB_STATUSES = [
  "requested",
  "reviewing",
  "ready",
  "confirmed",
  "scheduled",
  "in_progress",
  "completed",
  "follow_up",
  "canceled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type PropertyProfile = Record<string, string | number | boolean | null>;
export type RoomPlan = { id: string; label: string; selected: boolean; note?: string };

const STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  requested: ["reviewing", "canceled"],
  reviewing: ["ready", "requested", "canceled"],
  ready: ["confirmed", "reviewing", "canceled"],
  confirmed: ["scheduled", "reviewing", "canceled"],
  scheduled: ["in_progress", "canceled"],
  in_progress: ["completed", "scheduled"],
  completed: ["follow_up"],
  follow_up: [],
  canceled: [],
};

export const COMMUNICATION_PLAN = [
  { stage: "Request received", owner: "System", channel: "Email when enabled", timing: "Immediately" },
  { stage: "Scope qualified", owner: "Operator", channel: "Call or email", timing: "After property review" },
  { stage: "Proposal accepted", owner: "Operator", channel: "Written confirmation", timing: "Before scheduling" },
  { stage: "Crew proposed", owner: "Operator", channel: "Private crew workspace", timing: "After capacity check" },
  { stage: "Visit confirmed", owner: "Operator", channel: "Customer confirmation", timing: "After crew acceptance" },
  { stage: "Quality closeout", owner: "Operator", channel: "Documented follow-up", timing: "After completion" },
] as const;

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}
