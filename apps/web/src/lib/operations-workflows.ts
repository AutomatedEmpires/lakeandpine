export const QUALIFICATION_STATUSES = [
  "requested",
  "needs_information",
  "walkthrough_needed",
  "proposal_sent",
  "approved",
  "declined",
] as const;

export const SCHEDULE_STATUSES = [
  "tentative",
  "held",
  "confirmed",
  "en_route",
  "in_progress",
  "quality_review",
  "completed",
  "canceled",
] as const;

export const SERVICE_CASE_STATUSES = [
  "submitted",
  "triaged",
  "awaiting_customer",
  "investigating",
  "action_planned",
  "reclean_scheduled",
  "refund_pending",
  "resolved",
  "closed",
  "declined",
  "canceled",
] as const;

export const RECOVERY_STATUSES = ["planned", "approved", "scheduled", "completed", "canceled"] as const;
export const REFUND_STATUSES = [
  "requested",
  "approved",
  "declined",
  "ready_for_manual_processing",
  "processed",
  "failed",
  "canceled",
] as const;

export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export type ServiceCaseStatus = (typeof SERVICE_CASE_STATUSES)[number];
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];
export type RefundStatus = (typeof REFUND_STATUSES)[number];

const QUALIFICATION_TRANSITIONS: Record<QualificationStatus, readonly QualificationStatus[]> = {
  requested: ["needs_information", "walkthrough_needed", "proposal_sent", "declined"],
  needs_information: ["requested", "walkthrough_needed", "proposal_sent", "declined"],
  walkthrough_needed: ["proposal_sent", "needs_information", "declined"],
  proposal_sent: ["approved", "needs_information", "declined"],
  approved: [],
  declined: [],
};

const SCHEDULE_TRANSITIONS: Record<ScheduleStatus, readonly ScheduleStatus[]> = {
  tentative: ["held", "canceled"],
  held: ["confirmed", "tentative", "canceled"],
  confirmed: ["en_route", "held", "canceled"],
  en_route: ["in_progress", "confirmed", "canceled"],
  in_progress: ["quality_review", "confirmed"],
  quality_review: ["completed", "in_progress"],
  completed: [],
  canceled: [],
};

const SERVICE_CASE_TRANSITIONS: Record<ServiceCaseStatus, readonly ServiceCaseStatus[]> = {
  submitted: ["triaged", "canceled"],
  triaged: ["awaiting_customer", "investigating", "action_planned", "declined"],
  awaiting_customer: ["triaged", "investigating", "canceled"],
  investigating: ["awaiting_customer", "action_planned", "declined"],
  action_planned: ["reclean_scheduled", "refund_pending", "resolved"],
  reclean_scheduled: ["resolved", "action_planned"],
  refund_pending: ["resolved", "action_planned"],
  resolved: ["closed", "investigating"],
  closed: [],
  declined: ["closed", "investigating"],
  canceled: [],
};

const RECOVERY_TRANSITIONS: Record<RecoveryStatus, readonly RecoveryStatus[]> = {
  planned: ["approved", "canceled"],
  approved: ["scheduled", "completed", "canceled"],
  scheduled: ["completed", "approved", "canceled"],
  completed: [],
  canceled: [],
};

const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  requested: ["approved", "declined", "canceled"],
  approved: ["ready_for_manual_processing", "canceled"],
  declined: [],
  ready_for_manual_processing: ["processed", "failed", "canceled"],
  processed: [],
  failed: ["ready_for_manual_processing", "canceled"],
  canceled: [],
};

function allows<T extends string>(transitions: Record<T, readonly T[]>, from: T, to: T): boolean {
  return transitions[from].includes(to);
}

export function canTransitionQualification(from: QualificationStatus, to: QualificationStatus): boolean {
  return allows(QUALIFICATION_TRANSITIONS, from, to);
}

export function canTransitionSchedule(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return allows(SCHEDULE_TRANSITIONS, from, to);
}

export function canTransitionServiceCase(from: ServiceCaseStatus, to: ServiceCaseStatus): boolean {
  return allows(SERVICE_CASE_TRANSITIONS, from, to);
}

export function canTransitionRecovery(from: RecoveryStatus, to: RecoveryStatus): boolean {
  return allows(RECOVERY_TRANSITIONS, from, to);
}

export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return allows(REFUND_TRANSITIONS, from, to);
}
